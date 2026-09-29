import dagre from '@dagrejs/dagre'
import {
  Background, Controls, Handle, MarkerType, Position, ReactFlow,
  type Edge, type Node, type NodeProps, type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { fmtDuration, toolCalls } from '../derive'
import type { Agent, AgentEvent } from '../types'

const USER = 'user'
const RECENT_MS = 4000
const SIZE = { agent: { w: 230, h: 96 }, tool: { w: 150, h: 34 }, user: { w: 96, h: 40 } } as const

type AgentData = { agent: Agent; now: number; selected: boolean }
type ToolData = { label: string; count: number; running: number; failed: number }
type UserData = Record<string, never>

const AgentNode = memo(function AgentNode({ data }: NodeProps<Node<AgentData>>) {
  const { agent: a, now, selected } = data
  const end = a.ended_at ?? (a.status === 'completed' || a.status === 'failed' ? a.last_active : now)
  return (
    <div className={`agent-node st-${a.status} ${selected ? 'selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="agent-node-head">
        <span className={`dot st-${a.status}`} />
        <span className="agent-name" title={a.id}>{a.name}</span>
        <span className="kind">{a.kind}</span>
      </div>
      <div className="agent-action" title={a.current_action ?? a.current_task ?? ''}>
        {a.current_action ?? a.current_task ?? a.status}
      </div>
      <div className="agent-stats">
        <span title="tool calls">🛠 {a.tool_calls}</span>
        <span title="LLM calls">✦ {a.llm_calls}</span>
        <span title="messages">✉ {a.messages}</span>
        {a.errors > 0 && <span className="err" title="errors">⚠ {a.errors}</span>}
        <span className="dur">{a.started_at ? fmtDuration(end - a.started_at) : ''}</span>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
})

const ToolNode = memo(function ToolNode({ data }: NodeProps<Node<ToolData>>) {
  return (
    <div className={`tool-node ${data.running ? 'running' : ''} ${data.failed ? 'failed' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <span>{data.label}</span>
      <span className="count">×{data.count}{data.failed ? ` ⚠${data.failed}` : ''}</span>
    </div>
  )
})

const UserNode = memo(function UserNode(_: NodeProps<Node<UserData>>) {
  return (
    <div className="user-node">
      👤 User
      <Handle type="source" position={Position.Right} />
      <Handle type="target" position={Position.Left} />
    </div>
  )
})

const nodeTypes = { agent: AgentNode, tool: ToolNode, user: UserNode }

function layout(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: 24, ranksep: 90 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const n of nodes) {
    const s = SIZE[n.type as keyof typeof SIZE]
    g.setNode(n.id, { width: s.w, height: s.h })
  }
  for (const e of edges) g.setEdge(e.source, e.target)
  dagre.layout(g)
  return nodes.map((n) => {
    const p = g.node(n.id)
    const s = SIZE[n.type as keyof typeof SIZE]
    return { ...n, position: { x: p.x - s.w / 2, y: p.y - s.h / 2 } }
  })
}

interface Props {
  agents: Agent[]
  events: AgentEvent[]
  selectedAgent: string | null
  onSelect: (id: string | null) => void
  now: number
}

export function AgentGraph({ agents, events, selectedAgent, onSelect, now }: Props) {
  const [showTools, setShowTools] = useState(true)
  const flow = useRef<ReactFlowInstance | null>(null)

  const { nodes, edges, topology } = useMemo(() => {
    const nodes: Node[] = []
    const edges: Edge[] = []
    const ids = new Set(agents.map((a) => a.id))

    // messages aggregated per unordered agent pair, oriented by first direction seen
    const pairs = new Map<string, { source: string; target: string; count: number; last: number }>()
    for (const e of events) {
      if (e.event_type !== 'agent_message' || !e.source || !e.target) continue
      const key = [e.source, e.target].sort().join('|')
      const p = pairs.get(key) ?? { source: e.source, target: e.target, count: 0, last: 0 }
      p.count += 1
      p.last = e.timestamp
      pairs.set(key, p)
    }
    const hasUser = [...pairs.values()].some((p) => p.source === USER || p.target === USER)
    if (hasUser && !ids.has(USER)) nodes.push({ id: USER, type: 'user', position: { x: 0, y: 0 }, data: {} })

    for (const a of agents) {
      nodes.push({ id: a.id, type: 'agent', position: { x: 0, y: 0 }, data: { agent: a, now, selected: a.id === selectedAgent } })
      if (a.parent && ids.has(a.parent) && !pairs.has([a.parent, a.id].sort().join('|'))) {
        edges.push({ id: `spawn:${a.parent}>${a.id}`, source: a.parent, target: a.id, className: 'spawn-edge' })
      }
    }
    for (const [key, p] of pairs) {
      if ((p.source !== USER && !ids.has(p.source)) || (p.target !== USER && !ids.has(p.target))) continue
      const live = now - p.last < RECENT_MS
      edges.push({
        id: `msg:${key}`, source: p.source, target: p.target, label: `${p.count} msg`, animated: live,
        className: live ? 'msg-edge live' : 'msg-edge', markerEnd: { type: MarkerType.ArrowClosed },
      })
    }

    if (showTools) {
      const byTool = new Map<string, ToolData & { agent: string }>()
      for (const c of toolCalls(events)) {
        if (!ids.has(c.agent)) continue
        const key = `${c.agent}::${c.name}`
        const t = byTool.get(key) ?? { agent: c.agent, label: c.name, count: 0, running: 0, failed: 0 }
        t.count += 1
        if (c.status === 'running') t.running += 1
        if (c.status === 'failed') t.failed += 1
        byTool.set(key, t)
      }
      for (const [key, t] of byTool) {
        nodes.push({ id: `tool:${key}`, type: 'tool', position: { x: 0, y: 0 }, data: t })
        edges.push({
          id: `use:${key}`, source: t.agent, target: `tool:${key}`, animated: t.running > 0,
          className: t.failed ? 'tool-edge failed' : 'tool-edge',
        })
      }
    }
    const topology = nodes.map((n) => n.id).join(',') + '#' + edges.map((e) => e.id).join(',')
    return { nodes, edges, topology }
  }, [agents, events, selectedAgent, now, showTools])

  // re-layout only when the graph shape changes, not on every status tick
  const positions = useMemo(() => {
    const laid = layout(nodes, edges)
    return new Map(laid.map((n) => [n.id, n.position]))
  }, [topology])
  const placed = nodes.map((n) => ({ ...n, position: positions.get(n.id) ?? n.position }))

  useEffect(() => {
    const t = window.setTimeout(() => flow.current?.fitView({ duration: 300, padding: 0.15, maxZoom: 1.2 }), 60)
    return () => window.clearTimeout(t)
  }, [topology])

  return (
    <div className="graph">
      <div className="graph-toolbar">
        <label><input type="checkbox" checked={showTools} onChange={(e) => setShowTools(e.target.checked)} /> tools</label>
      </div>
      {agents.length === 0 ? (
        <div className="empty">Waiting for agent events…</div>
      ) : (
        <ReactFlow
          nodes={placed}
          edges={edges}
          nodeTypes={nodeTypes}
          onInit={(inst) => { flow.current = inst }}
          onNodeClick={(_, n) => onSelect(n.type === 'agent' ? n.id : null)}
          onPaneClick={() => onSelect(null)}
          nodesDraggable={false}
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
          minZoom={0.2}
          fitView
        >
          <Background gap={20} size={1} color="#1f2937" />
          <Controls showInteractive={false} />
        </ReactFlow>
      )}
    </div>
  )
}
